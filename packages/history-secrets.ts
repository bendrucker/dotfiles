// Two stores record every command: atuin, which syncs, and the plaintext
// $HISTFILE zsh keeps on disk. Each filters with its own engine, so a pattern
// fixed in one can silently rot in the other. Both tests read this list, which
// is what makes "dropped" mean dropped from both.

export interface HistoryCase {
  name: string;
  command: string;
}

export const secrets: HistoryCase[] = [
  {
    name: "an Anthropic key assigned to an env var",
    command:
      "export ANTHROPIC_API_KEY=sk-ant-api03-Aa0Bb1Cc2Dd3Ee4Ff5Gg6Hh7Ii8Jj9Kk0Ll1Mm2Nn3Oo4Pp5Qq6Rr7Ss8Tt9Uu0Vv1Ww2Xx3Yy4Zz5-_aAbB",
  },
  {
    name: "an OpenRouter key in a bearer header",
    command:
      "curl https://openrouter.ai/api/v1/chat -H 'Authorization: Bearer sk-or-v1-EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLEEX'",
  },
  {
    name: "a password in a one-shot env assignment",
    command: "PGPASSWORD=correct-horse-battery-staple psql -h db.internal",
  },
  { name: "a password passed as a long flag", command: "mysql -u root --password=hunter2 warehouse" },
  {
    name: "a mysql password attached to its flag, which no name=value or --flag value rule sees",
    command: "mysql -u root -pMyRealPassword123 warehouse",
  },
  { name: "a password under the short PASS name", command: "export DB_PASS=hunter2super-secret" },
  {
    name: "basic auth credentials in a -u pair",
    command: "curl -u admin:SuperSecretPass123 https://internal.example.com/api",
  },
  {
    name: "credentials in the userinfo of a url",
    command: "curl https://deploy:s3cr3t-deploy-password@artifacts.internal/build.tar.gz",
  },
  {
    name: "a Slack incoming webhook, whose id segments run longer than atuin's built-in pattern allows",
    command:
      "curl -X POST -d '{\"text\":\"deploy done\"}' https://hooks.slack.com/services/T024BTQMFK9/B0123ABCDEF/XXXXXXXXXXXXXXXXXXXXXXXXX",
  },
  { name: "an api key in a key=value argument", command: "vault kv put secret/app api_key=abcd1234efgh5678" },
  {
    name: "a GitHub personal access token",
    command: "gh auth login --with-token ghp_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0",
  },
  {
    name: "a lowercase AWS secret key name, which atuin's built-in list only matches uppercase",
    command: "aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  { name: "a Slack bot token in a flag", command: "slack --token xoxb-EXAMPLE-NOT-A-REAL-SLACK-TOKEN" },
  {
    name: "a GitLab token in a request header",
    command: "curl -H 'PRIVATE-TOKEN: glpat-EXAMPLEEXAMPLEEXAMPL' https://gitlab.example.com/api/v4/user",
  },
  {
    name: "a RubyGems api key",
    command: "gem push --key rubygems_0123456789abcdef0123456789abcdef01234567",
  },
  {
    name: "a Perplexity key",
    command: "export PERPLEXITY_API_KEY=pplx-0123456789abcdefghij0123456789abcdefghij",
  },
  {
    name: "an npm auth token written into the registry config",
    command: "npm config set //registry.npmjs.org/:_authToken=npm_EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE0",
  },
  { name: "any command typed behind a leading space", command: " echo this line began with a space" },
];

/** Ordinary commands, several of them near misses, that both stores must keep. */
export const ordinary: HistoryCase[] = [
  { name: "a bare git command", command: "git status" },
  { name: "a secret word in prose", command: 'gh pr create --title "Add a token bucket rate limiter"' },
  { name: "a search for the word secret", command: 'rg --files-with-matches "secret" docs/' },
  { name: "listing kubernetes secrets", command: "kubectl get secrets --namespace default" },
  { name: "an env assignment that is not a credential", command: "export EDITOR=nvim" },
  { name: "a flag whose value is a number", command: "bun test --timeout=5000" },
  { name: "docker env flags", command: "docker run -e NODE_ENV=production -p 8080:80 nginx" },
  { name: "a uid:gid pair, which is shaped like basic auth", command: "docker run -u 1000:1000 --rm alpine id" },
  { name: "mysql prompting for the password rather than carrying it", command: "mysql -u root -p warehouse" },
  { name: "a mysql flag that merely begins -p", command: "mysqldump --port 3307 --databases app" },
  { name: "an aws subcommand carrying no credential", command: "aws s3 ls s3://my-bucket" },
  { name: "a command that prints a token rather than containing one", command: "gcloud auth print-access-token" },
  { name: "a branch name that starts sk- and mentions secret", command: "git switch sk-history-secret-filter" },
  { name: "generating a key pair", command: "ssh-keygen -t ed25519 -f ~/.ssh/id_test" },
  { name: "a non-authorization header", command: "curl -H 'Accept: application/json' https://example.com/api/v1/status" },
  { name: "reading the atuin config", command: "cat ~/.config/atuin/config.toml" },
];
