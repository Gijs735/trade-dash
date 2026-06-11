# trade-dash
Dashboard to follow and track my swing trades

## Deployment

The GitHub Actions workflow in `.github/workflows/deploy-azure-storage.yml`
deploys the static website to Azure Blob Storage on every push to `main`, and
can also be started manually from the Actions tab.

Configure these repository secrets:

- `AZURE_STORAGE_ACCOUNT`: the storage account name.
- `AZURE_STORAGE_SAS_TOKEN`: a container-level SAS token. It may include or omit
  the leading `?`. The token needs permissions to read, add, create, write,
  delete, and list blobs.

By default the workflow deploys to the `$web` container used by Azure Static
Website hosting. To deploy to a different container, add a repository variable
named `AZURE_STORAGE_CONTAINER`.
