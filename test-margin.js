const fs = require('fs');
const html = `
<!DOCTYPE html>
<html>
<body>
  <div id="container" style="position: absolute; top: 0; left: 0; width: 100px;">
    <div id="child" style="margin-top: 50px; height: 20px; background: red;"></div>
  </div>
  <script>
    const c = document.getElementById('container');
    console.log(c.getBoundingClientRect());
  </script>
</body>
</html>
`;
fs.writeFileSync('C:\\Software\\conex\\test-margin.html', html);
