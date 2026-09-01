const { app } = require('@azure/functions');

// Required by Azure Static Web Apps Custom auth mode's "Role assignments API path".
// Tenant restriction is already enforced by the single-tenant Entra app
// registration, so no group/claim lookup is needed here — every authenticated
// Fuse user just needs the built-in 'authenticated' role, which Static Web
// Apps assigns automatically regardless of what this returns. An empty array
// is sufficient and keeps this endpoint maintenance-free.

app.http('getRolesForUsers', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'getRolesForUsers',
    handler: async (request, context) => {
        return {
            jsonBody: {
                roles: []
            }
        };
    }
});
