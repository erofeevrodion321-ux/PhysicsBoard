
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const boardWorld = document.getElementById("board-world");

const penButton = document.getElementById("pen");
const eraserButton = document.getElementById("eraser");
const handButton = document.getElementById("hand");
const clearButton = document.getElementById("clear");
const colorInput = document.getElementById("color");
const sizeInput = document.getElementById("size");
const statusText = document.getElementById("status");
const copyButton = document.getElementById("copy-link");

let tool = "pen";
let drawing = false;
let lastPoint = null;
let segments = [];
let pixelRatio = window.devicePixelRatio || 1;
let panX = 0;
let panY = 0;
const BOARD_SIZE = 10000;
let startPan = null;
let zoom = 1;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

// Подключаемся к комнате по WebSocket
const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(
    `${protocol}//${location.host}/ws/${ROOM_ID}`
);

socket.addEventListener("open", () => {
    statusText.textContent = "Подключено";
});

socket.addEventListener("close", () => {
    statusText.textContent = "Соединение потеряно";
});

socket.addEventListener("error", () => {
    statusText.textContent = "Ошибка соединения";
});

socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "init") {
        segments = data.segments || [];
        redraw();
    }

    if (data.type === "segment") {
        segments.push(data);
        drawSegment(data);
    }

    if (data.type === "erase") {
        applyErase(data);
    }

    if (data.type === "clear") {
        segments = [];
        redraw();
    }
});

// Подгоняем разрешение полотна под экран

function resizeCanvas() {
    const size = BOARD_SIZE;
    pixelRatio = window.devicePixelRatio || 1;

    canvas.width = size * pixelRatio;
    canvas.height = size * pixelRatio;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const viewport = document.getElementById("board-viewport");
    panX = (viewport.clientWidth - size) / 2;
    panY = (viewport.clientHeight - size) / 2;
    redraw();
    updateCanvasTransform();
}


function drawSegment(segment) {

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(segment.x1, segment.y1);
    ctx.lineTo(segment.x2, segment.y2);

    ctx.globalCompositeOperation = segment.isEraser ? "destination-out" : "source-over";
    ctx.strokeStyle = segment.color;
    ctx.lineWidth = segment.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
}

function pointToSegmentDistance(px, py, segment) {
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared === 0) {
        return Math.hypot(px - segment.x1, py - segment.y1);
    }

    const t = Math.max(0, Math.min(1,
        ((px - segment.x1) * dx + (py - segment.y1) * dy)
        / lengthSquared
    ));

    const x = segment.x1 + t * dx;
    const y = segment.y1 + t * dy;

    return Math.hypot(px - x, py - y);
}

function segmentsTouch(a, b, radius) {
    // Проверяем концы каждого отрезка относительно другого.
    // Для коротких штрихов этого достаточно как первой версии.
    return (
        pointToSegmentDistance(a.x1, a.y1, b) <= radius + a.size / 2 ||
        pointToSegmentDistance(a.x2, a.y2, b) <= radius + a.size / 2 ||
        pointToSegmentDistance(b.x1, b.y1, a) <= radius + b.size / 2 ||
        pointToSegmentDistance(b.x2, b.y2, a) <= radius + b.size / 2
    );
}

function applyErase(erase) {
    const eraserStroke = {
        x1: erase.x1,
        y1: erase.y1,
        x2: erase.x2,
        y2: erase.y2,
        size: erase.size
    };

    segments = segments.filter(segment => {
        // Старые штрихи ластика сохраняем для совместимости.
        if (segment.isEraser) return true;

        return !segmentsTouch(segment, eraserStroke, erase.size / 2);
    });

    redraw();
}

function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const segment of segments) {
        drawSegment(segment);
    }
}

// Координаты храним в диапазоне от 0 до 1,
// чтобы рисунок не зависел от размера экрана.

function getPoint(event) {
    const rect = canvas.getBoundingClientRect();

    return {
        x: (event.clientX - rect.left) / zoom,
        y: (event.clientY - rect.top) / zoom
    };
}




canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;

    if (tool === "hand") {
        drawing = true;
        startPan = {
            x: event.clientX - panX,
            y: event.clientY - panY
        };
        canvas.style.cursor = "grabbing";
        canvas.setPointerCapture(event.pointerId);
        return;
    }

    drawing = true;
    lastPoint = getPoint(event);
    canvas.setPointerCapture(event.pointerId);
});


canvas.addEventListener("pointermove", (event) => {
    if (tool === "hand" && drawing && startPan) {
        panX = event.clientX - startPan.x;
        panY = event.clientY - startPan.y;
        updateCanvasTransform();
        return;
    }

    if (!drawing || !lastPoint) return;

    const point = getPoint(event);

    // Ластик удаляет существующие линии
    if (tool === "eraser") {
        const erase = {
            type: "erase",
            x1: lastPoint.x,
            y1: lastPoint.y,
            x2: point.x,
            y2: point.y,
            size: Number(sizeInput.value) * 5
        };

        applyErase(erase);

        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(erase));
        }

        lastPoint = point;
        return;
    }

    // Обычное рисование ручкой
    const segment = {
        type: "segment",
        x1: lastPoint.x,
        y1: lastPoint.y,
        x2: point.x,
        y2: point.y,
        color: colorInput.value,
        size: Number(sizeInput.value),
        isEraser: false
    };

    drawSegment(segment);
    segments.push(segment);

    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(segment));
    }

    lastPoint = point;
});


function stopDrawing() {
    drawing = false;
    lastPoint = null;
    startPan = null;

    if (tool === "hand") {
        canvas.style.cursor = "grab";
    }
}

canvas.addEventListener("pointerup", stopDrawing);
canvas.addEventListener("pointercancel", stopDrawing);
canvas.addEventListener("lostpointercapture", stopDrawing);


penButton.addEventListener("click", () => {
    tool = "pen";
    penButton.classList.add("active");
    eraserButton.classList.remove("active");
    handButton.classList.remove("active");
    canvas.style.cursor = "crosshair";
});

eraserButton.addEventListener("click", () => {
    tool = "eraser";
    eraserButton.classList.add("active");
    penButton.classList.remove("active");
    handButton.classList.remove("active");
    canvas.style.cursor = "crosshair";
});

clearButton.addEventListener("click", () => {
    if (!confirm("Очистить доску у всех участников?")) return;
    if (socket.readyState !== WebSocket.OPEN) return;

    segments = [];
    redraw();
    socket.send(JSON.stringify({ type: "clear" }));
});

handButton.addEventListener("click", () => {
    tool = "hand";
    handButton.classList.add("active");
    penButton.classList.remove("active");
    eraserButton.classList.remove("active");
    canvas.style.cursor = "grab";
});

copyButton.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(location.href);
        copyButton.textContent = "Ссылка скопирована!";
        setTimeout(() => {
            copyButton.textContent = "Скопировать ссылку ученику";
        }, 2000);
    } catch {
        prompt("Скопируй ссылку на комнату:", location.href);
    }
});

function updateCanvasTransform() {
    boardWorld.style.transformOrigin = "0 0";
    boardWorld.style.transform =
        `translate(${panX}px, ${panY}px) scale(${zoom})`;

    document.getElementById("zoom-level").textContent =
        `${Math.round(zoom * 100)}%`;
}


function changeZoom(amount) {
    const oldZoom = zoom;
    const newZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, zoom + amount)
    );

    const viewport = document.getElementById("board-viewport");
    const centerX = viewport.clientWidth / 2;
    const centerY = viewport.clientHeight / 2;

    // Координаты точки в рабочей области до масштабирования
    const worldX = (centerX - panX) / oldZoom;
    const worldY = (centerY - panY) / oldZoom;

    zoom = newZoom;

    // Сохраняем эту же точку в центре экрана
    panX = centerX - worldX * zoom;
    panY = centerY - worldY * zoom;

    updateCanvasTransform();
}


document.getElementById("zoom-in").addEventListener("click", () => {
    changeZoom(0.25);
});

document.getElementById("zoom-out").addEventListener("click", () => {
    changeZoom(-0.25);
});

document.getElementById("reset-view").addEventListener("click", () => {
    zoom = 1;
    panX = 0;
    panY = 0;
    updateCanvasTransform();
});

canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 0.1 : -0.1);
}, { passive: false });

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
