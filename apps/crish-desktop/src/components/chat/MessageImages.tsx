import React from 'react';
import styles from '../ChatMessageRow.module.css';

interface MessageImagesProps {
  sources: string[];
}

export const MessageImages: React.FC<MessageImagesProps> = React.memo(({ sources }) => {
  if (!sources.length) return null;
  return (
    <div className={styles.inlineImages}>
      {sources.map((src) => (
        <img key={src} src={src} alt="" className={styles.mdImg} loading="lazy" />
      ))}
    </div>
  );
});

MessageImages.displayName = 'MessageImages';
