# rsync binaries (cwRsync)

Atlas uses rsync as the fastest file transfer protocol (3-10x faster than SCP).
The binaries are **not committed** to git (too large / license). You must add them manually.

## How to get them

1. Download **cwRsync Free** from https://itefix.net/cwrsync
2. Extract the archive
3. Copy these 3 files into this `bin/` folder:
   - `rsync.exe`
   - `ssh.exe`
   - `cygwin1.dll`

## Without these files

Atlas still works — it automatically falls back to **SCP** (fast) and then **SCP** (safe).
rsync is only used when the binaries are present AND the session uses key-based auth.
