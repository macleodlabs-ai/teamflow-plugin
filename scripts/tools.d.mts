/**
 * Types for the capability table, so the dashboard can read it.
 *
 * `tools.mjs` is the one place a tool's id and display name live, and
 * the consent page names the tool that asked (MACLEOD-604). A second
 * list in `src/` is a second list to forget, so the table is imported
 * rather than copied — and a `.mjs` import needs this to typecheck.
 *
 * Only what a consumer outside the plugin actually reads is declared.
 * The generator's own fields stay untyped rather than duplicated here,
 * where they would be one more thing to keep in step.
 */
export type ToolCapability = {
  id: string;
  name: string;
  automation: 'hooks' | 'git-hooks' | 'rules';
  [key: string]: unknown;
};

export declare const TOOL_CAPABILITIES: ToolCapability[];
export declare const BY_ID: Record<string, ToolCapability | undefined>;
export declare const AUTOMATION_LEVELS: string[];
export declare const VERIFICATION_SOURCES: string[];
export declare function capability(id: string): ToolCapability | undefined;
