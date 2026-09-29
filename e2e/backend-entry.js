'use strict';
// The backend process under the e2e stub: https-stub.js first, then the
// backend the app asked for (E2E_BACKEND_MAIN), started as its entry would be.
require('./https-stub');
require(process.env.E2E_BACKEND_MAIN).main();
