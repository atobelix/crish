document.addEventListener('DOMContentLoaded', () => {
  
  // --- 1. Navigation Sections Switcher ---
  const navButtons = document.querySelectorAll('.nav-btn');
  const sections = document.querySelectorAll('.showcase-section');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      navButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetId = btn.getAttribute('data-section');
      sections.forEach(sec => {
        if (sec.id === targetId) {
          sec.classList.add('active');
        } else {
          sec.classList.remove('active');
        }
      });
    });
  });


  // --- 2. Segmented Tab Control (Sliding Background) ---
  const segmentedControl = document.querySelector('.segmented-control');
  const segButtons = segmentedControl.querySelectorAll('.seg-btn');
  const sliderBack = segmentedControl.querySelector('.slider-back');

  segButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      segButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const index = parseInt(btn.getAttribute('data-index'), 10);
      sliderBack.style.transform = `translateX(${index * 100}%)`;
    });
  });


  // --- 3. Custom Dropdown Select ---
  const dropdown = document.getElementById('demo-dropdown-select');
  const trigger = dropdown.querySelector('.dropdown-trigger');
  const menu = dropdown.querySelector('.dropdown-menu');
  const items = dropdown.querySelectorAll('.menu-item');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('show');
  });

  items.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      items.forEach(sib => sib.classList.remove('selected'));
      item.classList.add('selected');
      trigger.querySelector('span').textContent = item.textContent;
      menu.classList.remove('show');
    });
  });

  document.addEventListener('click', () => {
    menu.classList.remove('show');
  });


  // --- 4. Auto-resizing Textarea ---
  const textarea = document.querySelector('.textarea-showcase');
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight - 6) + 'px';
  });


  // --- 5. Temperature Range Slider Value Update ---
  const slider = document.querySelector('.range-slider-showcase');
  const sliderVal = document.querySelector('.slider-val');

  slider.addEventListener('input', () => {
    sliderVal.textContent = parseFloat(slider.value).toFixed(1);
  });


  // --- 6. Clipboard Copy Action Button ---
  const copyBtn = document.querySelector('.btn-copy-clipboard');
  const copyTextSpan = copyBtn.querySelector('.txt');

  copyBtn.addEventListener('click', () => {
    const val = copyBtn.getAttribute('data-copy-val');
    
    // Write to clipboard
    navigator.clipboard.writeText(val).then(() => {
      copyBtn.classList.add('success');
      copyTextSpan.textContent = '已成功复制到剪贴板！';

      setTimeout(() => {
        copyBtn.classList.remove('success');
        copyTextSpan.textContent = '复制接口 Base URL';
      }, 1500);
    }).catch(err => {
      console.error('Failed to copy: ', err);
      alert('复制失败，请手动选择复制。');
    });
  });


  // --- 7. Tool Accordion Collapses Toggle ---
  const accordion = document.querySelector('.tool-invocation');
  const accHeader = accordion.querySelector('.tool-header');

  accHeader.addEventListener('click', () => {
    accordion.classList.toggle('expanded');
  });


  // --- 8. Global Dark Mode Toggle ---
  const themeSwitch = document.getElementById('theme-switch');

  themeSwitch.addEventListener('change', () => {
    if (themeSwitch.checked) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  });
});
