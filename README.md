# cache-keeper

Band above the prompt: prompt-cache time left, Warm, Keep 10h, Handoff.
Each Warm and Keep shows its cost and, on a subscription, its share of the usage limits: one warm against
the 5-hour window, a 10h keep against the weekly one. The share is learned from your own usage.
Handoff is suggested when the session goes off track: two judges (free signals and a small model check)
run side by side for 5 sessions, then the band asks which one to keep.

Command: `/cache warm | keep [hours] | stop | handoff | trial | judge signals|model|both|trial | show | hide`.

## Install

```
/plugin install cache-keeper --marketplace ankits3a/cache-keeper
```
