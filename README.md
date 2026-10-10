# cache-keeper

Band above the prompt: prompt-cache time left, Warm, Keep 12h, Handoff.
Each Warm and Keep shows its cost and, on a subscription, its share of the usage limits: one warm against
the 5-hour window, a 12h keep against the weekly one. The share is learned from your own usage.
The band also compares a prompt sent after 12h idle: kept warm (the pings plus a cached turn) against cold
(the whole context written to the cache again), e.g. "12h: keep 0.6% vs cold 1.0% wk".
Before Claude Code auto-compacts, it saves a handoff file (HANDOFF-<time>.md) and tells the summary where it is.
Your own /compact is left alone. If the file cannot be made, compaction runs as usual.
Handoff is suggested when the session goes off track: two judges (free signals and a small model check)
run side by side for 5 sessions, then the band asks which one to keep.

Command: `/cache warm | keep [hours] | stop | handoff | trial | judge signals|model|both|trial | show | hide`.

## Install

```
/plugin install cache-keeper --marketplace ankits3a/cache-keeper
```
