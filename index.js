/**
 * Host half of @local/dsh-katex-toolkit.
 *
 * Both features are pure page behaviour owned by the Client module (client.js): the clean-copy
 * rewrite is DOM work and the render cache wraps the `katex` entry of the browser module table.
 * The Host therefore contributes nothing but the bundle row in cordis.patch.yml, which is why this
 * apply is intentionally empty rather than a placeholder waiting for code.
 */
export function apply() {}
