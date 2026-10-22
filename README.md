# Sovara for Pi

Give Pi your team’s knowledge. Sovara automatically retrieves relevant lessons and records your sessions for review.

## Getting started

1. [Install Sovara Desktop and the CLI](https://docs.sovara-labs.com/get-started/installation). Open Desktop and complete setup.
2. Install the Pi extension, then start Pi from your project folder:

   ```sh
   pi install npm:@sovara/pi
   pi
   ```

3. Send a message in Pi. In Sovara Desktop, open the project matching your folder name.
4. Under **Lessons**, create a lesson:
   - **Title:** Python testing
   - **When to use:** When writing Python tests
   - **Content:** Use pytest and keep tests beside the code they cover.
5. Ask Pi to write a Python test. Open the recorded session in Sovara to see the lesson under **Lessons applied** on the model step.

## Using Sovara

Your sessions are recorded automatically. Relevant lessons are added to Pi’s context as you work.

- **`/sovara`** — Check your connection, project, and recording status.
- **`/reload`** — Reload after installation or changing your Sovara connection.
- **`pi update`** — Update installed Pi packages from your terminal.

Pi uses the local or remote connection selected in Sovara Desktop. Your project defaults to the folder where you start Pi. To choose another name, add `.pi/sovara.json`:

```json
{ "projectName": "my-project" }
```

To uninstall:

```sh
pi remove npm:@sovara/pi
```

## Palantir prompt caching

For Palantir models that support explicit prompt caching (verified with Sol 6.1),
set `"supportsExplicitPromptCacheMode": true` in the model's `compat` object in
Pi's `models.json`. The provider must be named `palantir` and use `openai-responses`.
Sovara then adds cache breakpoints to tool results so changing lessons do not
prevent reuse of the preceding conversation. Lessons remain request-only.
Other providers are unchanged; requests without a cache key, including
`cacheRetention: "none"`, receive no added breakpoints.

## License

MIT.
