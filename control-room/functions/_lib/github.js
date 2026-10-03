// Start a GitHub Actions workflow (the heavy work runs there). Returns "" on success, else a plain-English error.
export async function startWorkflow(env, workflow, inputs) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return "GitHub isn't connected yet (GITHUB_TOKEN / GITHUB_REPO not set).";
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "goldbar-control-room",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs }),
  });
  if (resp.ok) return "";
  return `GitHub refused to start the run (${resp.status}): ${(await resp.text()).slice(0, 200)}`;
}
