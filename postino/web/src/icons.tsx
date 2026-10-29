import type { SVGProps } from 'react';

type IconName =
  | 'inbox'
  | 'pin'
  | 'send'
  | 'draft'
  | 'archive'
  | 'spam'
  | 'trash'
  | 'block'
  | 'back'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'clip'
  | 'search'
  | 'menu'
  | 'pen'
  | 'x'
  | 'check'
  | 'chevronDown'
  | 'chevronRight'
  | 'bell'
  | 'news'
  | 'mail'
  | 'mailOpen'
  | 'unread'
  | 'folder'
  | 'settings'
  | 'plus'
  | 'more'
  | 'image'
  | 'download'
  | 'external'
  | 'refresh'
  | 'people'
  | 'keyboard'
  | 'shield'
  | 'eye'
  | 'eyeOff'
  | 'move'
  | 'undo'
  | 'star'
  | 'alert'
  | 'logout'
  | 'drag'
  | 'filter';

const paths: Record<IconName, string> = {
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  pin: '<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>',
  send: '<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
  draft: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  archive: '<path d="M3 4h18v4H3z"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/>',
  spam: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M12 8v5"/><path d="M12 16.5v.5"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  reply: '<path d="M10 6L4 12l6 6"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
  replyAll: '<path d="M8 6L2 12l6 6"/><path d="M13 6l-6 6 6 6"/><path d="M7 12h8a6 6 0 0 1 6 6v1"/>',
  forward: '<path d="M14 6l6 6-6 6"/><path d="M20 12H10a6 6 0 0 0-6 6v1"/>',
  clip: '<path d="M20 11l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2"/><path d="M7 9h7M7 12h7M7 15h4"/>',
  mail: '<path d="M3 6h18v12H3z"/><path d="M3 7l9 6 9-6"/>',
  mailOpen: '<path d="M3 9l9-6 9 6v11H3z"/><path d="M3 9l9 6 9-6"/>',
  unread: '<path d="M3 6h12"/><path d="M3 6v12h18v-7"/><path d="M3 7l9 6 4-2.7"/><circle cx="19.5" cy="5.5" r="2.5"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/>',
  download: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v6H4V5h6"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 13.5A6.5 6.5 0 0 1 21.5 20"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.5 6.2A10 10 0 0 1 12 6c6.5 0 10 6 10 6a16 16 0 0 1-3.2 3.7"/><path d="M6.6 6.6A16 16 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  move: '<path d="M3 6h6l2 2h10v11H3z"/><path d="M12 11v6"/><path d="M9.5 13.5L12 11l2.5 2.5"/>',
  undo: '<path d="M4 10h11a5 5 0 0 1 0 10h-3"/><path d="M8 6l-4 4 4 4"/>',
  star: '<path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.3L12 17.5l-5.6 2.9 1.1-6.3L3 9.7l6.2-.9z"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4"/><path d="M12 17.5v.5"/>',
  logout: '<path d="M10 4H5v16h5"/><path d="M14 8l5 4-5 4"/><path d="M19 12H9"/>',
  drag: '<circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
};

export type { IconName };

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: paths[name] }}
      {...rest}
    />
  );
}
