import {
  ImagePromptReviewModal,
  type ImagePromptOverride,
  type ImagePromptReviewItem,
} from "../../../components/ui/ImagePromptReviewModal";

type TrackerPortraitReviewModalProps = {
  items: ImagePromptReviewItem[] | null;
  onCancel: () => void;
  onConfirm: (overrides: ImagePromptOverride[]) => void;
};

/** "Expose media prompts before sending", for a manual Character Tracker portrait. */
export function TrackerPortraitReviewModal({ items, onCancel, onConfirm }: TrackerPortraitReviewModalProps) {
  return (
    <ImagePromptReviewModal
      open={Boolean(items?.length)}
      items={items ?? []}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
