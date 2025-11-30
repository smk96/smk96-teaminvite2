import { Application } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import router from "./team.ts";

const app = new Application();

// Error handling
app.addEventListener("error", (evt) => {
    console.log(evt.error);
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log("Server running on http://localhost:8000");
await app.listen({ port: 8000 });
