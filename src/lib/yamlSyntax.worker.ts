import { parseYamlSyntaxIssues } from './yamlPreview'
import type { YamlSyntaxResponse, YamlSyntaxRequest } from './yamlSyntaxAnalysis'

self.onmessage = (event: MessageEvent<YamlSyntaxRequest>) => {
  const { id, text } = event.data
  try {
    self.postMessage({ id, issues: parseYamlSyntaxIssues(text) } satisfies YamlSyntaxResponse)
  } catch (error) {
    self.postMessage({ id, error: String(error) } satisfies YamlSyntaxResponse)
  }
}
