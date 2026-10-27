import type { Meta, StoryObj } from "storybook-solidjs-vite";
import "../../styles.css";
import "./SocialCards.stories.css";
import { CONTENT_COLLECTIONS } from "../../lib/content";

// The committed social cards, keyed by their path under `content-art/`, for
// example `news/og/introducing-openbot.png`.
const CARD_FILES = import.meta.glob<string>("../../../content-art/*/og/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const CARDS = CONTENT_COLLECTIONS.flatMap((collection) =>
  collection.articles.map((article) => ({
    key: `${collection.id}/${article.slug}`,
    title: article.title,
    src: CARD_FILES[`../../../content-art/${collection.id}/og/${article.slug}.png`],
  })),
);

const meta = {
  title: "Site/Social cards",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every article's social card the way X shows a large link card: the image, with
 * `og:title` on a dark label over its bottom left and the domain under it. The
 * title in the image must stay clear of that label.
 */
export const OnX: Story = {
  render: () => (
    <div class="story-social-cards">
      {CARDS.map((card) => (
        <figure class="story-x-card">
          <div class="story-x-card-media">
            <img src={card.src} alt="" width={1200} height={630} />
            <span class="story-x-card-title">{card.title}</span>
          </div>
          <figcaption class="story-x-card-domain">From openbot.run</figcaption>
        </figure>
      ))}
    </div>
  ),
};
