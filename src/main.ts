import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig } from "./app/app.config";
import { initLogging, logError, formatError } from "./app/core/logger";

initLogging();

bootstrapApplication(App, appConfig).catch((err) => logError(`Bootstrap failed: ${formatError(err)}`));
