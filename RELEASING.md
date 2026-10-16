# Releasing @sovara/pi

The npm artifact contains only `src/`, README, LICENSE, and package.json. Pi loads
TypeScript directly. There is no bundled Pi runtime or install script.

## Initial setup

An npm owner of `@sovara` publishes the first version from a tested release commit
with `npm publish --access public`. Then configure an npm trusted publisher:

```sh
npm trust github @sovara/pi --repo SovaraLabs/pi-sovara --file publish.yml --allow-publish
npm trust list @sovara/pi
```

The publisher must name the exact repository and workflow above; no GitHub
environment is used. GitHub-hosted runners authenticate using OIDC. Do not add
an npm write token to repository secrets. npm may require browser/2FA verification
for the owner's initial publication or trust configuration.

## Subsequent releases

1. Update the version in package.json and package-lock.json with
   `npm version <version> --no-git-tag-version`. Update the changelog.
2. Run `npm ci`, `npm run check`, and `npm run test:package`. Merge the release PR
   into main after CI passes.
3. Tag that main commit with `git tag v<version>` and `git push origin v<version>`.
4. Wait for the Publish workflow to pass. Verify `npm view @sovara/pi version`
   and install the published version using `pi install npm:@sovara/pi@<version>`
   in an isolated Pi agent directory.

The workflow rejects tags that differ from the package version or point outside
main's history. It repeats the tests and packed-install check before publishing
with provenance. Published versions cannot be overwritten; fixes require a new
version. The first release is published locally to bootstrap the npm package;
its tag workflow may fail if it attempts to republish that existing version.
Create the first tag before adding the publish workflow to main, or do not push
a bootstrap tag. Future tags are the only normal release trigger.
