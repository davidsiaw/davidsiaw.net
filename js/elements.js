// Periodic table detail popover (source/playground/elements.weave).
// The element data is embedded in the page at build time as #elements-data;
// clicking an element fills in #element-dialog and opens it as a modal.
(function () {
  var data = JSON.parse(document.getElementById('elements-data').textContent);
  var dialog = document.getElementById('element-dialog');
  var card = dialog.querySelector('.element-dialog-card');
  var content = dialog.querySelector('.element-dialog-content');

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function render(el) {
    var rows = el.details.map(function (row) {
      return '<dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd>';
    }).join('');

    return (
      '<header class="element-dialog-head">' +
        '<div class="element-dialog-tile">' +
          '<span class="element-number">' + el.number + '</span>' +
          '<span class="element-symbol">' + esc(el.symbol) + '</span>' +
        '</div>' +
        '<div>' +
          '<h2 id="element-dialog-name">' + esc(el.name) + '</h2>' +
          '<span class="element-dialog-category">' + esc(el.category) + '</span>' +
        '</div>' +
      '</header>' +
      (el.summary ? '<p class="element-dialog-summary">' + esc(el.summary) + '</p>' : '') +
      '<dl class="element-dialog-facts">' + rows + '</dl>' +
      (el.source ? '<a class="element-dialog-source" href="' + esc(el.source) + '">more on Wikipedia →</a>' : '')
    );
  }

  function open(number) {
    var el = data[number];
    if (!el) return;
    dialog.className = 'element-dialog cat-' + el.slug;
    content.innerHTML = render(el);
    card.scrollTop = 0;
    dialog.showModal();
  }

  document.querySelector('.elements-grid').addEventListener('click', function (e) {
    var cell = e.target.closest('.element');
    if (cell) open(cell.dataset.number);
  });

  dialog.querySelector('.element-dialog-close').addEventListener('click', function () {
    dialog.close();
  });

  // a click on the backdrop lands on the dialog itself; clicks on the card land inside it
  dialog.addEventListener('click', function (e) {
    if (e.target === dialog) dialog.close();
  });

  // discovery timeline: cover the elements discovered after the chosen year.
  // Cells without data-year are ancient and always shown. The group 3 markers
  // carry the year of the first element in their row.
  var slider = document.getElementById('elements-year');
  var output = document.getElementById('elements-year-output');
  var cells = Array.prototype.slice.call(document.querySelectorAll('.element'));
  var markers = Array.prototype.slice.call(document.querySelectorAll('.element-marker'));

  function coveredAt(node, year) {
    var covered = node.dataset.year !== undefined && Number(node.dataset.year) > year;
    node.classList.toggle('undiscovered', covered);
    return covered;
  }

  function applyYear() {
    var year = Number(slider.value);
    var known = 0;
    cells.forEach(function (cell) {
      cell.disabled = coveredAt(cell, year);
      if (!cell.disabled) known++;
    });
    markers.forEach(function (marker) {
      marker.tabIndex = coveredAt(marker, year) ? -1 : 0;
    });
    var when = year < Number(slider.dataset.first) ? 'antiquity' : year;
    output.textContent = when + ' · ' + known + ' of ' + cells.length + ' known';
  }

  slider.addEventListener('input', applyYear);
  applyYear();
})();
