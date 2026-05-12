import { app } from "./app.js";
import { config } from "./config/env.js";

app.listen(config.port, config.host, () => {
  console.log(`Backend listening on http://${config.host}:${config.port}`);
});
