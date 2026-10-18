import test from 'node:test'
import assert from 'node:assert/strict'
import { validationIndexView,validationIndexViewSchema } from '../lib/flow-validation.js'

test('bounded wire history reports the true total and every omitted native location',()=>{
  const order=Array.from({length:1000},(_,i)=>i.toString(16).padStart(16,'0')),locations=Object.fromEntries(order.map((id,i)=>[id,{seq:i}]))
  const view=validationIndexView({order,locations});validationIndexViewSchema.parse(view)
  assert.equal(view.total,1000);assert.equal(view.omitted,872);assert.equal(view.order.length,128)
  assert.equal(Object.keys(view.locations).length,128);assert.equal(view.order[0],order[872]);assert.equal(view.locations[order[0]],undefined)
  assert.equal(order.length,1000)
})
test('empty native history neither invents checks nor reports omitted facts',()=>{
  assert.deepEqual(validationIndexView({order:[],locations:{}}),{order:[],locations:{},total:0,omitted:0})
})
