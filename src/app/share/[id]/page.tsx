import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getSharePost } from "@/lib/share-posts";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const post = await getSharePost(id);
  if (!post) return { title: "Look not found · ClosetAI" };
  const title = "A look from ClosetAI";
  const description = `${post.caption} ${post.hashtags.join(" ")}`.slice(0, 200);
  const imagePath = `/share/${post.id}/opengraph-image`;
  return {
    title,
    description,
    openGraph: { title, description, type: "article", images: [{ url: imagePath, width: 1200, height: 630, alt: "Virtual try-on look" }] },
    twitter: { card: "summary_large_image", title, description, images: [imagePath] },
  };
}

export default async function SharedPostPage({ params }: Props) {
  const { id } = await params;
  const post = await getSharePost(id);
  if (!post) notFound();

  return (
    <main className="share-page">
      <header className="share-topbar"><Link className="brand" href="/" aria-label="ClosetAI home"><span className="brand-mark"><span /><span /><span /></span><span>closet<span className="brand-ai">ai</span></span></Link><span>VIRTUAL TRY-ON LOOK</span></header>
      <article className="share-post">
        <div className={`share-post-art share-post-${post.crop}`}><img src={post.imageUrl} alt="ClosetAI virtual try-on" /></div>
        <div className="share-post-copy"><span className="card-kicker">A LOOK MADE WITH CLOSETAI</span><p className="share-post-caption">{post.caption}</p>{post.voiceCaption && <p className="share-post-voice">“{post.voiceCaption}”</p>}<p className="share-post-tags">{post.hashtags.join("  ")}</p><time dateTime={new Date(post.createdAt).toISOString()}>{new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(post.createdAt)}</time></div>
      </article>
      <Link className="share-create-link" href="/">Create your own look <span aria-hidden="true">↗</span></Link>
    </main>
  );
}
