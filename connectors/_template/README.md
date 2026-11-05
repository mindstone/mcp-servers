# Local input file support

For tools that read local user files, vendor `src/file-read-context.ts` from
`test-harness/src/file-read-context.ts`. Advertise `FILE_READ_CAPABILITIES`,
declare the actual input selectors in tool `_meta['files/readInputs']`, and
pass SDK request `extra` to `fileReadContext(server.server.getClientCapabilities(), extra)`.
Pass the returned context down to the actual file reader. `centralReadPath`
looks up the exact raw path and concrete argument location; use its result
for the existing open/read/upload operation. Only standalone mode should run
local root containment or raw-input symlink restrictions. Keep file type,
size, descriptor identity, and output-write checks. Never read mode metadata
from tool arguments.
