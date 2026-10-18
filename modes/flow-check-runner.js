import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID,createHash } from 'node:crypto'
import { runCheckRequest,checkBinding } from '../lib/flow-check-run.js'
import { declaredCheckDescriptor } from '../lib/flow-evidence.js'

export function createCheckRunner(agent,{tools,evidence,validation,resources,jobs}){
  const ledger=evidence.ledger,lifetime=new AbortController(),owner=agent.id
  const signalFor=exec=>AbortSignal.any([exec.signal,lifetime.signal])
  const resourceKey=resource=>path.resolve(agent.session.header.cwd)+'\0'+resource
  async function call(exec,name,args,callId=randomUUID()){
    const result=await tools.execute({agent,name,arguments:args,callId,rootCallId:exec.rootCallId,parent:exec.token,signal:signalFor(exec)})
    for(const context of result.additionalContexts??[])exec.deferContext(context)
    return {callId,result}
  }
  const recordFor=exec=>[...ledger.history.values()].find(row=>row.callId===exec.callId||exec.name==='job_output'&&row.jobId===exec.arguments.job_id)
  async function recover(exec,result){
    const value=result.value??{},job=value.job
    if(job&&['completed','failed','killed'].includes(job.status))resources.releaseJob(owner,job.id)
    const receipt=recordFor(exec)
    if(!receipt?.testObservation)return
    if(receipt.state==='unfinished'||receipt.exitCode===null)return
    const truncated=Boolean(value.stdout?.truncated||value.stderr?.truncated)
    const paths=job?.output?.spillPaths??[]
    if(!truncated&&!(job&&receipt.testObservation?.dataTruncated&&paths.length))return
    const streams=job?paths.map(file=>({spillPath:file,truncated:true})):[value.stdout,value.stderr].filter(Boolean)
    if(streams.some(stream=>stream.truncated&&!stream.spillPath)||streams.length>4)return
    const chunks=[],sources=[]
    for(const stream of streams){
      if(!stream.truncated){chunks.push(stream.text??'');continue}
      // Only producer-owned structured spill paths are eligible. Permission is
      // checked by the actual native read, never by following a stdout filename.
      const readId=randomUUID();ledger.auxiliaryReads.add(readId)
      let permitted
      try{permitted=await call(exec,'read',{file_path:stream.spillPath,limit:1},readId)}finally{ledger.auxiliaryReads.delete(readId)}
      if(permitted.result.isError)return
      let handle
      try{
        const beforePath=await fs.realpath(stream.spillPath);handle=await fs.open(stream.spillPath,'r')
        const before=await handle.stat()
        if(!before.isFile()||before.size>16777216)return
        const buffer=Buffer.alloc(before.size+1),read=await handle.read(buffer,0,buffer.length,0),after=await handle.stat()
        if(read.bytesRead!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||beforePath!==await fs.realpath(stream.spillPath))return
        const bytes=buffer.subarray(0,read.bytesRead)
        sources.push({path:stream.spillPath,sha256:createHash('sha256').update(bytes).digest('hex'),nativeReadCallId:permitted.callId});chunks.push(bytes.toString('utf8'))
      }catch{return}finally{await handle?.close()}
    }
    ledger.replaceNativeOutput(receipt,chunks.join('\n'),sources)
  }
  return {
    recover,
    async run(raw,exec){
      const args=runCheckRequest.parse(raw),toolName=args.toolName??(process.platform==='win32'?'pwsh':'bash')
      if(!declaredCheckDescriptor(ledger.root,args.command,args.workdir,toolName))throw new Error('Check working directory must be inside this workspace')
      const files=[...new Set([...args.files,...args.definitions].map(file=>ledger.fileName(file)))]
      if(files.some(file=>!file)||files.length>24)throw new Error('Select at most 24 workspace inputs, including verification definitions')
      args.definitions=[...new Set(args.definitions.map(file=>ledger.fileName(file)))]
      const callId=randomUUID(),key=args.resource?resourceKey(args.resource):null
      // Reconstruct recent same-owner resource bindings from native receipts
      // after a cold process; no private job, process or waiter is restored.
      if(key)for(const row of validation.all(128).runs){
        if(row.originSessionId!==owner||row.binding?.resource!==args.resource||!row.jobId)continue
        try{const job=jobs.get(row.jobId,owner);if(['running','stopping'].includes(job.status))resources.restore(key,{owner,callId:row.callId,jobId:row.jobId})}catch{}
      }
      if(key){
        const lease=resources.acquire(key,owner,callId)
        if(!lease.acquired){
          if(lease.owner===owner&&lease.jobId){
            // Join only the caller's owned job, through native job_output and
            // its normal permission/cursor/wait semantics. Never launch twice.
            const joined=await call(exec,'job_output',{job_id:lease.jobId,wait:true,timeout_ms:30000})
            await evidence.settle();validation.flush(ledger)
            return {accepted:!joined.result.isError,launched:false,requestedCheckNotRun:true,resourceBusy:true,joinedJobId:lease.jobId,native:joined.result}
          }
          return {accepted:false,launched:false,resourceBusy:true,resource:args.resource,ownerSessionId:lease.owner,
            reason:'A cooperating check owns this resource. Its owner must collect the native terminal result; no second process was launched.'}
        }
      }
      let keep=false
      try{
        for(const file of files){
          // Explicit file parameters authorize a request, not access. Read
          // guards and the host's filesystem permissions make the decision.
          {
            const observed=await call(exec,'read',{file_path:file,limit:1})
            if(observed.result.isError)return {accepted:false,launched:false,reason:'Native input read denied or failed',file,native:observed.result}
            await evidence.settle()
          }
        }
        const inputs=await ledger.snapshot(files)
        if(files.some(file=>!inputs[file]))return {accepted:false,launched:false,reason:'Input fingerprint unavailable; narrow the bounded files or use native execution with unknown scope'}
        const binding=checkBinding(args,{inputs,previous:validation.previous(args.label)})
        ledger.boundExecutions.set(callId,binding)
        const nativeArgs={command:args.command,description:args.label,...(args.workdir?{workdir:args.workdir}:{}),
          ...(args.timeoutMs!==undefined?{timeoutMs:args.timeoutMs}:{}),...(args.run_in_background!==undefined?{run_in_background:args.run_in_background}:{})}
        const native=await call(exec,toolName,nativeArgs,callId)
        await evidence.settle();validation.flush(ledger)
        const receipt=[...ledger.history.values()].find(row=>row.callId===callId),jobId=native.result.value?.jobId
        if(key&&jobId&&!native.result.isError){resources.bind(key,callId,jobId);keep=true
          try{if(!['running','stopping'].includes(jobs.get(jobId,owner).status)){resources.release(key,callId);keep=false}}catch{}
        }
        return {accepted:!native.result.isError,launched:native.result.isError?receipt?null:false:Boolean(receipt),checkId:receipt?.checkId??null,jobId:jobId??null,
          inputScope:'agent-selected files; dependency completeness unknown',nativeCallId:callId,native:native.result,
          receipt:receipt?validation.find(receipt.checkId):null}
      }finally{ledger.boundExecutions.delete(callId);if(key&&!keep)resources.release(key,callId)}
    },
    dispose(){lifetime.abort();resources.disposeOwner(owner,{keepJobs:true})},
  }
}
