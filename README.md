# trade-dash
Dashboard to follow and track my swing trades

## Deployment

The GitHub Actions workflow in `.github/workflows/deploy-azure-storage.yml`
deploys the static website to Azure Blob Storage on every push to `main`, and
can also be started manually from the Actions tab. It also runs on weekday
schedule and refreshes `strategy-inputs.json` from Strategy's latest SEC 8-K
before uploading the static files.

To refresh the local filing inputs without deploying:

```sh
node scripts/update-strategy-inputs.mjs
```

Set `SEC_USER_AGENT` if you want the SEC requests to identify a specific
contact.

Configure these repository secrets:

- `AZURE_STORAGE_ACCOUNT`: the storage account name.
- `AZURE_STORAGE_SAS_TOKEN`: a SAS token. It may include or omit the leading
  `?`. The token needs permissions to read, add, create, write, delete, and
  list blobs. A container-level SAS for the target container is the narrowest
  option, but an account SAS that covers Blob service containers also works.

By default the workflow deploys to the `$web` container used by Azure Static
Website hosting. To deploy to a different container, add a repository variable
named `AZURE_STORAGE_CONTAINER`.
