import { env } from "./config/env.js";
import { createApp } from "./http/app.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`Solchan V2 backend listening on http://localhost:${env.PORT}`);
});

