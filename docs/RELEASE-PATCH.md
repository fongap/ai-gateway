# Release naming

Release archive names are derived from `package.json`:

```text
release/<package.name>-v<package.version>.zip
release/<package.name>-v<package.version>.tar.gz
release/SHA256SUMS
```

Do not repeat the package or repository name in release scripts or GitHub Actions.
