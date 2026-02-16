import DeckPageClient from "./deck-page-client";

export default function DeckPage({ params }: { params: { id: string } }) {
  return <DeckPageClient id={params.id} />;
}
