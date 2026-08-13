      (function () {
        try {
          var t = localStorage.getItem('crish_theme');
          if (t !== 'dark' && t !== 'default' && t !== 'light') {
            var raw = localStorage.getItem('crish_settings') || localStorage.getItem('conex_pi_settings');
            if (raw) {
              var s = JSON.parse(raw);
              t = s && s.theme;
            }
          }
          if (t === 'light') t = 'default';
          if (t !== 'dark') t = 'default';
          document.documentElement.setAttribute('data-theme', t);
          document.documentElement.classList.add(t === 'dark' ? 'theme-dark' : 'theme-light');
        } catch (e) {
          document.documentElement.setAttribute('data-theme', 'default');
        }
        try {
          var fr = localStorage.getItem('crish_fonts');
          if (!fr) {
            var raw2 = localStorage.getItem('crish_settings') || localStorage.getItem('conex_pi_settings');
            if (raw2) {
              var s2 = JSON.parse(raw2);
              if (s2 && s2.fonts) fr = JSON.stringify(s2.fonts);
            }
          }
          if (fr) {
            var f = JSON.parse(fr);
            if (f && f.uiFont) document.documentElement.setAttribute('data-ui-font', String(f.uiFont).indexOf('local:') === 0 ? 'local' : f.uiFont);
            if (f && f.monoFont) document.documentElement.setAttribute('data-mono-font', String(f.monoFont).indexOf('local:') === 0 ? 'local' : f.monoFont);
          }
        } catch (e2) {}
      })();
