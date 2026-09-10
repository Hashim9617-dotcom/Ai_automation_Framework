/**
 * What a captured node can actually be DONE to.
 *
 * **Both doors converged on this from opposite directions**, which is why it
 * lives here rather than in either of them:
 *
 * - **Door B** (a QA's clause -> an element) found that a flattened
 *   accessibility tree lists every visible label twice — the control, and the
 *   text on its face — so counting matches called almost everything ambiguous
 *   and refused it (`docs/phase-2-authored-cases.md` §12).
 * - **Door A** (a command -> generated cases) found the same nodes from the
 *   other side: the first real model call returned assertions on
 *   `role: "StaticText"` for *"Documents"* and *"File Explorer"*, unprompted,
 *   because the prompt rendered the capture's own roles and offered
 *   presentational duplicates as though they were controls
 *   (`docs/phase-2-generation.md` §L.5).
 *
 * A rule learned resolving a human's sentence turned out to be a rule the
 * generator needed. Two copies of it would drift, and the drift would be
 * invisible — each door's tests would keep passing against its own version.
 *
 * The layering matters too: `authored/` already imports `generation/`, so the
 * shared rule cannot live in `authored/` without a cycle. It is neither door's
 * property.
 */
import type { AccessibilityNode } from '../types/ai';

/**
 * Roles that are TEXT rather than a control.
 *
 * A CDP tree flattens a control and the text inside it into sibling nodes, so a
 * button and the words on its face both appear carrying the same accessible
 * name. These are the second half of that pair.
 */
export const TEXT_ROLES = ['StaticText', 'InlineTextBox'];

/**
 * ARIA roles, per the W3C role list — the vocabulary Playwright's `getByRole`
 * speaks.
 *
 * The capture speaks CDP, which emits `StaticText`, `RootWebArea`, `LineBreak`
 * and `generic` besides. `getByRole('StaticText', …)` returns zero WITHOUT
 * throwing, so a text node handed to it was reported as absent from the live
 * page — blaming the capture for a vocabulary mismatch of ours.
 */
export const ARIA_ROLES = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button',
  'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary',
  'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis',
  'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion',
  'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu',
  'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation',
  'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio',
  'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript',
  'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox',
  'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
];

/** Every role that can be a target at all: a real ARIA role, or text. */
export const CANDIDATE_ROLES = [...ARIA_ROLES, ...TEXT_ROLES];

/** Is this a text node rather than a control? */
export const isTextRole = (role: string): boolean => TEXT_ROLES.includes(role);

/**
 * How a node may be acted on. **The distinction collapsing this is what caused
 * the defect**, so it is a type rather than a convention.
 *
 * - `control` — may be clicked AND asserted on. `getByRole` reaches it.
 * - `text` — may be asserted on, never clicked. `getByText` reaches it.
 * - `scaffolding` — neither. `RootWebArea`, `LineBreak`, `generic`: tree
 *   structure, not page content, and no locator addresses them meaningfully.
 */
export type Affordance = 'control' | 'text' | 'scaffolding';

export function affordanceOf(role: string): Affordance {
  if (isTextRole(role)) return 'text';
  return ARIA_ROLES.includes(role) ? 'control' : 'scaffolding';
}

/**
 * Collapses a control and its own text into the one control it is.
 *
 * **The rule, precisely:** within a set of nodes that already share an
 * accessible name, a TEXT node is dropped **only if a non-text node is present
 * in that same set**. Nothing else is touched.
 *
 * - `button "Search"` + `StaticText "Search"` -> one candidate, the button.
 * - `StaticText "No employees registered yet."` alone -> KEPT. A label with no
 *   interactive partner is a real target, and dropping it loses coverage
 *   silently — the direction that fails quietly.
 * - `button "Save"` + `link "Save"` -> both KEPT. Two real controls sharing a
 *   name is genuine ambiguity.
 *
 * Note what it never does: **it cannot pick between two real candidates.**
 */
export function collapseTextDuplicates<T extends { role: string }>(candidates: T[]): T[] {
  const hasControl = candidates.some((node) => !isTextRole(node.role));
  if (!hasControl) return candidates;
  return candidates.filter((node) => !isTextRole(node.role));
}

/**
 * Drops every text node whose name a CONTROL in the same state already carries.
 *
 * The whole-state form of `collapseTextDuplicates`, for rendering rather than
 * for resolving one clause. A prompt that lists both `link "Documents"` and
 * `StaticText "Documents"` is offering the model two ways to name one thing, and
 * the model picked the one no locator can address.
 *
 * A text node whose name NO control carries survives — it is the only node that
 * names that content, and a generator that could not assert on page text would
 * be unable to check most of what a QA writes a Then clause about.
 */
export function dedupeTextAgainstControls<T extends { role: string; name: string }>(
  nodes: T[],
): T[] {
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const controlNames = new Set(
    nodes.filter((node) => !isTextRole(node.role)).map((node) => norm(node.name)),
  );
  return nodes.filter((node) => !isTextRole(node.role) || !controlNames.has(norm(node.name)));
}

/** Convenience for capture nodes specifically. */
export const addressableNodes = (nodes: AccessibilityNode[]): AccessibilityNode[] =>
  dedupeTextAgainstControls(nodes).filter((node) => affordanceOf(node.role) !== 'scaffolding');
