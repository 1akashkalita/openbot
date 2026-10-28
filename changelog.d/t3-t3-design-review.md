### Changed

- Settings pages have three clear text levels: a larger page title, bold section titles, and the
  rows below them. Before, section titles were smaller than their rows. In agent settings, group
  titles are now larger than the sidebar text.
- Lines and dim text in the dark theme have more contrast. Placeholder text in fields is now less
  bright than the text that you type.
- Dialogs, menus and cards use one set of corner radii. All dialogs now have the same corners.
- Direct messages use the same text size as channels. In the sidebar, the time and the message
  preview of an agent now have the same size, weight and colour, lighter than the name.
- All search fields have the same corners as other fields.
- A switch that is off has a grey thumb, so it no longer looks on in the light theme.
- Icons use one stroke width and the standard icon sizes in all of the app. The stroke is a little
  heavier, so icons read as clearly as the text beside them.
- Text uses the optical sizes of Inter: small text is more open and large titles are tighter.
- Copy and Expand on a code block show when you point at the block or move to it with the keyboard.
- The failed-task tray uses neutral colours, a warning icon and a secondary Continue button.
- Sidebar rows no longer show role chips, so names have more space. Screen readers still read the
  role.
- Agent names in channel activity and the usage ring use neutral text colours.
- Secondary buttons have a visible background. Composer buttons have the same hover colour.
- Labels in Mermaid diagrams sit on the diagram background, not on a separate box. Boxes have
  rounded corners, a raised fill and a clear edge in both themes.
- In the server menu, all server names start at the same edge. A check at the end of the row marks
  the current server.
- All selects on a settings page have the same width, so the controls make one column.
- The white logo colour has a visible edge in the light theme. The selected colour has no shadow.
- In a code preview, the Preview and Code switch stands beside the language label.
- Reassign in the failed-task tray is a button like Continue.
- The rail shows the current page in the light theme. Usage rings in the rail have the icon stroke.
- A switch that is off has a visible track on a card in both themes.
- The selected side panel tab has a fill in the light theme too.
- In agent settings and other forms, the Model field has the same up and down arrows as the selects
  beside it.
- The buttons in the failed-task tray have the same text size as the tray message.
- The selected agent colour and face have no shadow.
- Settings pages have a Back button before the title, as the usage page has. Escape now also closes
  the usage and schedule pages.

### Fixed

- Notifications show below the window header, so they no longer cover the header buttons.
- Reassign in the failed-task tray no longer looks disabled.
- A file in a message no longer shows a stray "@" before it, or a wide gap after it.
- Small code labels in code previews and in chat visuals used the default text size because their
  size token was missing. They now use the small text size.
