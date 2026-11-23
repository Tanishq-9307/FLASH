// Safe markdown renderer (M1-10, ARCHITECTURE.md §8, DESIGN.md §5.4).
//
// Rules, enforced here so no caller can forget them:
// - Raw HTML is never rendered: react-markdown parses no HTML without the
//   rehype-raw plugin (deliberately not installed), so HTML in the source
//   shows up as plain text.
// - Remote images are never rendered: an image renders its alt text only
//   (or nothing when there is none), so a reply can never make the browser
//   fetch a tracking pixel or leak the request to a third party.
// - Links open in a new tab with rel="noopener noreferrer" and show their
//   destination domain next to the link text, so the destination is visible
//   before it is clicked.
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

function hostnameOf(href: string | undefined): string | null {
  if (!href) return null;
  try {
    return new URL(href).hostname;
  } catch {
    return null;
  }
}

const components: Components = {
  img: ({ alt }) =>
    alt ? <span className="text-text-muted">{alt}</span> : null,
  a: ({ href, children }) => {
    const domain = hostnameOf(href);
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-cyan underline"
      >
        {children}
        {domain ? <span className="text-text-muted"> ({domain})</span> : null}
      </a>
    );
  },
};

export default function SafeMarkdown({ text }: { text: string }) {
  return <ReactMarkdown components={components}>{text}</ReactMarkdown>;
}
