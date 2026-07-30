import React from 'react';
import type { MessageImageRef } from '../../store/types';
import { ImageTile } from './ImageTile';
import styles from './ImageGallery.module.css';

export interface ImageGalleryProps {
  images: MessageImageRef[];
  className?: string;
}

export const ImageGallery: React.FC<ImageGalleryProps> = React.memo(
  ({ images, className }) => {
    if (!images.length) return null;
    return (
      <div className={`${styles.gallery}${className ? ` ${className}` : ''}`}>
        {images.map((img) => (
          <ImageTile key={img.id} image={img} />
        ))}
      </div>
    );
  }
);
