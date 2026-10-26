// SPDX-License-Identifier: GPL-3.0-only
// The keyboard shortcut list, shown by ? in the popup and under Settings > Keyboard.
export const HELP: Array<[string, Array<[string, string]>]> = [
  ['Anywhere in Chrome', [['Ctrl Shift L', 'Open Litewarden with search ready']]],
  [
    'In the popup',
    [
      ['type', 'Search names, usernames, sites, notes, folders'],
      ['↑ ↓', 'Move'],
      ['Enter', 'Fill the selected login'],
      ['Alt ← →', 'Previous or next folder'],
      ['Alt U', 'Copy username'],
      ['Alt P', 'Copy password'],
      ['Alt T', 'Copy 2FA code'],
      ['Alt E', 'Open the item'],
      ['Alt O', "Open the login's site and fill it"],
      ['Esc', 'Clear search, then close'],
      ['?', 'This list'],
    ],
  ],
  [
    'In an item',
    [
      ['Alt R', 'Show or hide the password'],
      ['Ctrl S', 'Save changes'],
      ['Esc', 'Back'],
    ],
  ],
];

export function HelpRows() {
  return (
    <>
      {HELP.map(([g, rows]) => (
        <>
          <div class="h-g">{g}</div>
          {rows.map(([k, d]) => (
            <div class="h-row">
              <span class="h-keys">
                {k.split(' ').map((x) => (
                  <kbd>{x}</kbd>
                ))}
              </span>
              <span>{d}</span>
            </div>
          ))}
        </>
      ))}
    </>
  );
}
