import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "prism-dlmm", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
