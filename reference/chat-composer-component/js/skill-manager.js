/* ==========================================================================
   Skill Search & Insertion Component Module
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const skillSearchInput = document.getElementById('skillSearchInput');
  const fileZone = document.getElementById('fileZone');

  if (skillSearchInput) {
    skillSearchInput.addEventListener('input', function() {
      const query = this.value.toLowerCase().trim();
      document.querySelectorAll('.skill-item').forEach(item => {
        const name = item.getAttribute('data-name').toLowerCase();
        item.style.display = name.includes(query) ? 'flex' : 'none';
      });
    });
  }

  document.querySelectorAll('.skill-item').forEach(item => {
    item.addEventListener('click', () => {
      const skillName = item.getAttribute('data-name');
      if (!fileZone) return;

      const tag = document.createElement('div');
      tag.className = 'skill-tag';
      tag.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
        <span>${skillName}</span>
        <div class="skill-tag-remove" onclick="window.removeFileCard(this)">✕</div>
      `;
      fileZone.appendChild(tag);
      if (window.updateSendButtonState) window.updateSendButtonState();
      if (window.closeAllPopovers) window.closeAllPopovers();
    });
  });
});
