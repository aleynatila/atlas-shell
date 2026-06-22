# How to Release

## Patch / Minor / Major

```sh
# pick one
npm run release:patch   # 0.4.6 → 0.4.7
npm run release:minor   # 0.4.6 → 0.5.0
npm run release:major   # 0.4.6 → 1.0.0
```

This bumps the version in `package.json`, `tauri.conf.json`, and `Cargo.toml`, commits, tags, and pushes. GitHub Actions then builds and publishes the release automatically.

## Manual (specific version)

```sh
npm version 0.5.0
git push origin master --tags
```

## Check release status

```sh
gh run list --limit 5
gh run watch
```

## View / edit the release after it publishes

```sh
gh release view v0.4.7
gh release edit v0.4.7 --notes "fix typo in notes"
```

## Delete a bad release and re-tag

```sh
gh release delete v0.4.7 --yes
git tag -d v0.4.7
git push origin :refs/tags/v0.4.7
```

Bundan sonraki workflow run'larında da kod değişikliği yapmadan önce:

- npm run build → frontend hataları (7-8 sn)
- cd src-tauri && cargo check → Rust hataları (~1 dk, sonraki çalıştırmalarda daha hızlı)
