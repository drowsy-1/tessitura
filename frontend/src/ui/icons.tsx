import type { SVGProps } from 'react'

const P: Record<string, string> = {
  play: 'M7 5.5v13l11-6.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  record: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  loop: 'M17 4.5l3 3-3 3M20 7.5H8.5A4.5 4.5 0 0 0 4 12M7 19.5l-3-3 3-3M4 16.5h11.5A4.5 4.5 0 0 0 20 12',
  metronome: 'M9 3.5h6l4 17H5zM12 16l5-9M8 16h8',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12',
  piano: 'M3 4h18v16H3zM8 4v10M13 4v10M18 4v10M8 14v6M13 14v6M18 14v6',
  drums: 'M4 9c0-2 3.6-3.5 8-3.5S20 7 20 9s-3.6 3.5-8 3.5S4 11 4 9zM4 9v7c0 2 3.6 3.5 8 3.5s8-1.5 8-3.5V9M15 3l-2 5M9 3l2 5',
  wave: 'M2 12h2l2-6 3 12 3-15 3 18 3-12 2 3h2',
  mixer: 'M6 4v16M12 4v16M18 4v16M3.5 14h5M9.5 8h5M15.5 12h5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  arrange: 'M3 5h8M13 5h8M3 12h13M18 12h3M3 19h5M10 19h11',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  save: 'M5 4h11l4 4v12H4V4zM8 4v5h7V4M8 20v-6h8v6',
  download: 'M12 4v11M7 10l5 5 5-5M4 20h16',
  upload: 'M12 20V9M7 14l5-5 5 5M4 4h16',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronUp: 'M6 15l6-6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  folder: 'M3 6h6l2 2h10v11H3z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  pencil: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  cursor: 'M5 3l14 8-6 2-3 6z',
  eraser: 'M9 20h11M5 15l9-9 5 5-8 8H7z',
  headphones: 'M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3z',
  power: 'M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  magnet: 'M5 4h4v8a3 3 0 0 0 6 0V4h4v8a7 7 0 0 1-14 0zM5 8h4M15 8h4',
  follow: 'M4 12h10M10 7l5 5-5 5M19 4v16',
  scene: 'M8 5v14l11-7z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  commit: 'M4 12h16M14 6l6 6-6 6',
  back: 'M20 12H4M10 6l-6 6 6 6',
  chord: 'M5 18V6M10 18V9M15 18V4M20 18V11',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6M11 8v6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
  reverse: 'M20 7H6l3-3M6 7l3 3M4 17h14l-3-3M18 17l-3 3',
}

export type IconName = keyof typeof P

export function Icon({ name, size = 16, fill, ...rest }: { name: IconName; size?: number; fill?: boolean } & SVGProps<SVGSVGElement>) {
  const solid = fill ?? ['play', 'stop', 'record', 'scene'].includes(name)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...rest}>
      <path
        d={P[name]}
        fill={solid ? 'currentColor' : 'none'}
        stroke={solid ? 'none' : 'currentColor'}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
