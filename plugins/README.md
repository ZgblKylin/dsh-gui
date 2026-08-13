# plugins/

Drop your local DeepSeek Harness plugin packages here.

The harness installs plugins into a *profile* (for the web surface, the `web`
profile). During a run you can add a plugin by pointing `dsh plugin` at a
package that lives in this directory:

```powershell
# from the repository root
dsh plugin --profile web add link:./plugins/my-plugin
```

`DSH_HOME` is pinned to `./.dsh` by the desktop shell (and `scripts/setup.ps1`),
so installed plugins and agent presets land under `.dsh/` inside this
repository — nothing is written to `~/.dsh` or any global location.
