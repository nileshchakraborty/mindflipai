const windows = new Map();
const taskbarApps = document.getElementById("taskbar-apps");
const startButton = document.getElementById("start-button");
const startMenu = document.getElementById("start-menu");
const clock = document.getElementById("clock");

let zIndexCounter = 10;

const appTitles = {
  word: "Word",
  excel: "Excel",
  powerpoint: "PowerPoint",
  paint: "Paint",
};

const initWindow = (windowEl) => {
  const app = windowEl.dataset.app;
  windows.set(app, windowEl);

  const titleBar = windowEl.querySelector(".window-title");
  let offsetX = 0;
  let offsetY = 0;
  let isDragging = false;

  titleBar.addEventListener("pointerdown", (event) => {
    isDragging = true;
    const rect = windowEl.getBoundingClientRect();
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    windowEl.setPointerCapture(event.pointerId);
    focusWindow(app);
  });

  titleBar.addEventListener("pointermove", (event) => {
    if (!isDragging) return;
    const x = Math.max(0, event.clientX - offsetX);
    const y = Math.max(0, event.clientY - offsetY);
    windowEl.style.left = `${x}px`;
    windowEl.style.top = `${y}px`;
  });

  titleBar.addEventListener("pointerup", (event) => {
    isDragging = false;
    titleBar.releasePointerCapture(event.pointerId);
  });

  windowEl.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      if (action === "minimize") {
        windowEl.classList.remove("active");
      }
      if (action === "close") {
        windowEl.classList.remove("active");
        removeTaskbarButton(app);
      }
    });
  });
};

const focusWindow = (app) => {
  const windowEl = windows.get(app);
  if (!windowEl) return;
  zIndexCounter += 1;
  windowEl.style.zIndex = zIndexCounter;
  windowEl.classList.add("active");
  addTaskbarButton(app);
};

const addTaskbarButton = (app) => {
  if (taskbarApps.querySelector(`[data-taskbar='${app}']`)) return;
  const button = document.createElement("button");
  button.dataset.taskbar = app;
  button.textContent = appTitles[app];
  button.addEventListener("click", () => {
    const windowEl = windows.get(app);
    const isActive = windowEl.classList.contains("active");
    windowEl.classList.toggle("active", !isActive);
    if (!isActive) {
      focusWindow(app);
    }
  });
  taskbarApps.appendChild(button);
};

const removeTaskbarButton = (app) => {
  const button = taskbarApps.querySelector(`[data-taskbar='${app}']`);
  if (button) button.remove();
};

const setupDesktopLaunchers = () => {
  document.querySelectorAll(".desktop-icon").forEach((icon) => {
    icon.addEventListener("click", () => {
      focusWindow(icon.dataset.app);
    });
  });

  document.querySelectorAll("#start-menu [data-app]").forEach((button) => {
    button.addEventListener("click", () => {
      focusWindow(button.dataset.app);
      toggleStartMenu(false);
    });
  });
};

const toggleStartMenu = (forceState) => {
  const shouldOpen = forceState ?? !startMenu.classList.contains("active");
  startMenu.classList.toggle("active", shouldOpen);
  startButton.setAttribute("aria-expanded", String(shouldOpen));
  startMenu.setAttribute("aria-hidden", String(!shouldOpen));
};

startButton.addEventListener("click", () => toggleStartMenu());

window.addEventListener("click", (event) => {
  if (!startMenu.contains(event.target) && event.target !== startButton) {
    toggleStartMenu(false);
  }
});

const setupClock = () => {
  const update = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };
  update();
  setInterval(update, 1000);
};

const setupWordToolbar = () => {
  const toolbar = document.querySelector("#window-word .window-toolbar");
  toolbar.addEventListener("click", (event) => {
    const command = event.target.closest("button")?.dataset.command;
    if (command) {
      document.execCommand(command, false);
    }
  });
};

const setupExcelGrid = () => {
  const grid = document.getElementById("excel-grid");
  const formulaInput = document.getElementById("excel-formula");
  const columns = "ABCDEFGHIJ".split("");

  grid.appendChild(document.createElement("div"));
  columns.forEach((col) => {
    const header = document.createElement("div");
    header.className = "excel-header";
    header.textContent = col;
    grid.appendChild(header);
  });

  for (let row = 1; row <= 10; row += 1) {
    const rowLabel = document.createElement("div");
    rowLabel.className = "excel-row-label";
    rowLabel.textContent = row;
    grid.appendChild(rowLabel);

    columns.forEach((col) => {
      const cell = document.createElement("div");
      cell.className = "excel-cell";
      cell.contentEditable = "true";
      cell.dataset.cell = `${col}${row}`;
      cell.addEventListener("focus", () => {
        formulaInput.value = cell.dataset.formula ?? cell.textContent ?? "";
      });
      cell.addEventListener("blur", () => {
        const raw = cell.textContent?.trim() ?? "";
        if (raw.startsWith("=")) {
          cell.dataset.formula = raw;
          cell.textContent = evaluateFormula(raw, grid);
        } else {
          cell.dataset.formula = "";
        }
      });
      grid.appendChild(cell);
    });
  }
};

const evaluateFormula = (expression, grid) => {
  const sanitized = expression
    .slice(1)
    .replace(/[A-J](10|[1-9])/g, (match) => {
      const cell = grid.querySelector(`[data-cell='${match}']`);
      const value = parseFloat(cell?.textContent ?? "0");
      return Number.isFinite(value) ? String(value) : "0";
    });

  if (!/^[0-9+\-*/().\s]+$/.test(sanitized)) {
    return "#ERR";
  }

  try {
    const result = Function(`"use strict"; return (${sanitized});`)();
    return Number.isFinite(result) ? String(result) : "#ERR";
  } catch (error) {
    return "#ERR";
  }
};

const setupPowerPoint = () => {
  const slidesList = document.getElementById("slides-list");
  const slideCanvas = document.getElementById("slide-canvas");
  const addButton = document.getElementById("add-slide");
  const slides = [
    {
      title: "Welcome Slide",
      content: slideCanvas.innerHTML,
    },
  ];

  const renderSlides = (activeIndex) => {
    slidesList.innerHTML = "";
    slides.forEach((slide, index) => {
      const thumb = document.createElement("button");
      thumb.className = "slide-thumb";
      if (index === activeIndex) thumb.classList.add("active");
      thumb.innerHTML = `<strong>Slide ${index + 1}</strong><div>${slide.title}</div>`;
      thumb.addEventListener("click", () => selectSlide(index));
      slidesList.appendChild(thumb);
    });
  };

  const selectSlide = (index) => {
    slideCanvas.innerHTML = slides[index].content;
    slideCanvas.dataset.active = String(index);
    renderSlides(index);
  };

  slideCanvas.addEventListener("input", () => {
    const index = Number(slideCanvas.dataset.active ?? 0);
    slides[index].content = slideCanvas.innerHTML;
    const titleMatch = slideCanvas.querySelector("h2");
    slides[index].title = titleMatch?.textContent ?? `Slide ${index + 1}`;
    renderSlides(index);
  });

  addButton.addEventListener("click", () => {
    slides.push({
      title: `Slide ${slides.length + 1}`,
      content: "<h2>New Slide</h2><p>Start presenting.</p>",
    });
    selectSlide(slides.length - 1);
  });

  selectSlide(0);
};

const setupPaint = () => {
  const canvas = document.getElementById("paint-canvas");
  const ctx = canvas.getContext("2d");
  const colorInput = document.getElementById("paint-color");
  const sizeInput = document.getElementById("paint-size");
  const clearButton = document.getElementById("paint-clear");

  let drawing = false;

  const resizeCanvas = () => {
    const parent = canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    const scale = Math.min(rect.width / 640, rect.height / 400, 1);
    canvas.style.width = `${640 * scale}px`;
    canvas.style.height = `${400 * scale}px`;
  };

  const startDraw = (event) => {
    drawing = true;
    ctx.beginPath();
    ctx.moveTo(event.offsetX, event.offsetY);
  };

  const draw = (event) => {
    if (!drawing) return;
    ctx.strokeStyle = colorInput.value;
    ctx.lineWidth = Number(sizeInput.value);
    ctx.lineCap = "round";
    ctx.lineTo(event.offsetX, event.offsetY);
    ctx.stroke();
  };

  const stopDraw = () => {
    drawing = false;
    ctx.closePath();
  };

  canvas.addEventListener("pointerdown", startDraw);
  canvas.addEventListener("pointermove", draw);
  canvas.addEventListener("pointerup", stopDraw);
  canvas.addEventListener("pointerleave", stopDraw);

  clearButton.addEventListener("click", () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
};

const setupWebGLWallpaper = () => {
  const canvas = document.getElementById("xp-wallpaper");
  const gl = canvas.getContext("webgl");
  if (!gl) return;

  const vertexShaderSource = `
    attribute vec2 position;
    void main() {
      gl_Position = vec4(position, 0.0, 1.0);
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;
    uniform vec2 resolution;
    uniform float time;
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      float wave = sin((uv.x + time * 0.05) * 10.0) * 0.02;
      vec3 color = mix(vec3(0.02, 0.4, 0.7), vec3(0.3, 0.8, 0.4), uv.y + wave);
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  const compileShader = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };

  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexShaderSource));
  gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource));
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );

  const positionLocation = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const resolutionLocation = gl.getUniformLocation(program, "resolution");
  const timeLocation = gl.getUniformLocation(program, "time");

  const resize = () => {
    canvas.width = window.innerWidth * window.devicePixelRatio;
    canvas.height = window.innerHeight * window.devicePixelRatio;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const render = (timestamp) => {
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    gl.uniform1f(timeLocation, timestamp * 0.001);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(render);
  };

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(render);
};

const init = () => {
  document.querySelectorAll(".window").forEach(initWindow);
  setupDesktopLaunchers();
  setupClock();
  setupWordToolbar();
  setupExcelGrid();
  setupPowerPoint();
  setupPaint();
  setupWebGLWallpaper();
};

init();
