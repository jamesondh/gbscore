# driver

- `hUGEDriver.asm` and `include/` are hUGEDriver at `a3c69884eea9f8a452c48fef7b724941950c2af7`
  (github.com/SuperDisk/hUGEDriver), unmodified. hUGEDriver is public domain. It's the driver commit that
  hUGETracker `aa259a49` pins, and the one gbscore compiles songs for.
- `fxx.patch` is `27fe5f3` from the driver's `latest-stuff` branch, so that `Fxx` sets all four groove steps.
  `build.sh` applies it to a copy.
- `player.asm` is the ROM gbscore plays songs on, set up the way a CrossZGB game runs the driver.
- `player.gbc` and `player.sym` are built by `build.sh` and committed, so nothing else needs rgbds. It uses rgbds
  0.7.0: put its `rgbasm` on your PATH, or set `RGBDS` to the directory it's in.
