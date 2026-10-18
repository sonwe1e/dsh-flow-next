# Flow Next for DeepSeek Harness

[中文](#中文说明) · [License](LICENSE) · [Compatibility and validation](docs/validation.md)

An experimental **native DSH agent preset**, combining task context, native/PTC interface selection, execution evidence, and stage reports. It preserves the host's permission system and full tool capability selection. It does not add a second model or an autonomous benchmark loop.

This is the standalone distribution of the author's Flow Next 1.8.3 mode. It is independently maintained and is not an official DeepSeek product. It is a separate project from other tools named Flow Next.

## Install

Tested with **DeepSeek Harness 0.2.1-rc.2**. The bundle declares this exact host version because DSH's preview APIs change quickly.

Open DSH's **Plugins** page, choose the external bundle installation option, and enter:

```text
https://github.com/sonwe1e/dsh-flow-next.git#v1.8.3
```

The Plugin Manager installs and enables the bundle in the current profile. When DSH requires a restart, restart it, create a new conversation, and choose **Flow Next（试用）** before its first turn. Run `/flow-next status` to check the actual loaded version. Installing files does not migrate an existing conversation.

If you already use an earlier private distribution that registers the `flow-next` preset, disable that bundle before enabling this one; both register the same preset identifier. This release does not modify an existing installation automatically.

The official CLI's `dsh plugin --profile <name> add <spec>` installs a dependency. If using that path, also select the installed bundle in the profile's Plugins page; a dependency on disk alone does not establish activation.

## Use

Give it your ordinary task. It can answer a small question directly or work through repository changes using existing instructions and checks. Complex work can use the following tools and commands without turning every answer into a report:

| Surface | Purpose |
|---|---|
| `flow_select` | Choose native tools or PTC for a later request boundary while retaining full capabilities. |
| `flow_task` | Link native task entries to observed artifacts, checks, gaps, and a next action. |
| `flow_run_check` | Execute one check with explicit inputs and expected names through native execution and permission controls. |
| `flow_check` | Inspect execution observations; retain prospective scope, coverage declarations, and explanations. |
| `flow_stage` | Read a stage report, keeping failures, skips, disabled and unknown results distinct. |
| `/flow-next status` | Show the loaded version, current interface, and switch budget. |
| `/flow-next report`, `task`, `history`, `stage` | Read the relevant retained state without requesting a model response. |

A recorded zero exit, an agent's coverage declaration, and product acceptance remain different claims. The plugin cannot certify semantic correctness, visual quality, or that every relevant test was selected. Historical observations retain their provenance and do not become fresh acceptance merely by resuming a conversation.

## Development

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

The unit tests exercise the existing state, evidence, coordination, and check mechanisms. The separate installed-host smoke test uses fixed responses and blocks provider dispatch; see [validation](docs/validation.md). There is no claimed general improvement in task success, speed, or cost. Run comparative model trials separately when evaluating those outcomes.

The runtime files are under `lib/` and `modes/`. The root entry registers only Flow Next. The research benchmark panel, personal feedback records, model experiments, and project transcripts are excluded from this distribution. Runtime utility names such as `telemetry.js` describe local parsing helpers; this bundle does not mount the research collector or configure a remote reporting destination. DSH itself retains its own data and telemetry settings.

## Distribution

This package uses the official `dsh.bundle.patch` manifest and a Cordis patch. The repository is tagged `dsh-plugin` for community discovery. Its [custom market index](marketplace/index.json) follows DSH's documented format and pins install sources to Git commits; add the raw index URL under **Plugins → Discover → Add index source** after enabling **Custom plugin markets**.

```text
https://raw.githubusercontent.com/sonwe1e/dsh-flow-next/main/marketplace/index.json
```

The index also lists the companion [Ambitious Prompt](https://github.com/sonwe1e/ambitious-prompt) skill bundle. The index is a community-maintained source, with no claim of official review or endorsement. Native mode functionality requires DSH; copying these files into another agent's skills directory does not reproduce the runtime mechanisms.

References: [official plugin bundles](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/README.md), [official custom market format](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md), [community contribution guidance](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md).

## 中文说明

Flow Next 是 DeepSeek Harness 的原生模式插件，保留原生权限和完整工具能力，增加任务上下文、native/PTC 切换、检查执行证据与阶段报告。它不强制简单任务填写计划或输出报告，检查记录也不自动等于产品验收。

在 DSH 的插件页面安装上面的 Git 地址，启用后新建会话，首轮前选择「Flow Next（试用）」，用 `/flow-next status` 核对版本。当前公开版仅声明与实际验证过的 DSH 0.2.1-rc.2 兼容；预览版宿主升级后应重新验证。

本仓库独立整理运行代码和相关回归测试，未发布研究工作区、真实项目会话或个人配置。它不是 DeepSeek 官方产品。源码采用 MIT 许可证；宿主预设快照的来源与原许可证见 [NOTICE.md](NOTICE.md)。
