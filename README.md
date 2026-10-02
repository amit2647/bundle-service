# bundle-service

Bundle service for OmniCore's profession-bundle platform — the registry of profession bundles and the installer that applies one to an organization, step by step.

Port 4008; reached through Kong at `/api/bundles`. Profession-neutral: what it
stores and how it behaves comes from the organization's installed bundle (see `bundle-sdk`).

Follows the shared service layout: `src/app.js`, `routes/`, `controllers/`, `services/`
(SQL lives there), and the copied `middleware/` (JWT + live access grants,
`requirePermission`). Schema is owned by the `migrations` repo, never by this service.

```bash
npm test && npm run lint
```
