/**
 * Page-wide atmosphere: halftone drift at the edges, film grain, vignette and
 * a soft magenta field. Purely decorative, never interactive.
 *
 * The layers are fixed and pointer-events-free so they read as the room the
 * interface sits in, not as content. Routes that want a quieter field pass
 * `quiet` and get a reduced halftone and bloom.
 */
export default function Atmosphere({ quiet = false }: { quiet?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`atmosphere${quiet ? " atmosphere-quiet" : ""}`}
    >
      <div className="atmosphere-bloom" />
      <div className="atmosphere-halftone atmosphere-halftone-a" />
      <div className="atmosphere-halftone atmosphere-halftone-b" />
      <div className="atmosphere-grain" />
      <div className="atmosphere-vignette" />
    </div>
  );
}
