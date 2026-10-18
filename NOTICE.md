# Attribution and distribution scope

Flow Next's local implementation and tests were developed by the project's contributors and are distributed here under the MIT License.

`modes/native-coding.json` is a snapshot of the native coding preset composition supplied by DeepSeek Harness and subsequently used as Flow Next's base. The DeepSeek Harness project is maintained at https://github.com/deepseek-ai/deepseek-harness and licensed under MIT. Its original notice and complete license are retained in `third-party/DeepSeek-Harness-LICENSE.txt`. Changes to the persona and additional Flow Next policies are local project changes. No claim is made that the snapshot equals the latest upstream composition.

This standalone package retains runtime version 1.8.3. It replaces the private package namespace with `@sonwe1e/dsh-flow-next` and mounts only the Flow Next preset. It excludes the original research benchmark application and data. Original private model trials are not distributed or presented as fresh evidence for this package.

DeepSeek and other product names belong to their owners. This is an independently maintained community project and does not imply their endorsement. Other unrelated projects using the name Flow Next are not the source of this implementation.
