#!/usr/bin/env node

import { run } from "../install.mjs";

await run(process.argv.slice(2));
