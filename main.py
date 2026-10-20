
import json
import uuid
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "boards.json"
SAVED_BOARDS_DIR = BASE_DIR / "saved_boards"

SAVED_BOARDS_DIR.mkdir(exist_ok=True)


def load_boards():
    loaded = {}

    # Сначала загружаем доски из отдельных файлов.
    for file in SAVED_BOARDS_DIR.glob("*.json"):
        try:
            board_id = file.stem
            loaded[board_id] = json.loads(
                file.read_text(encoding="utf-8")
            )
        except (json.JSONDecodeError, OSError):
            print(f"Не удалось загрузить доску: {file.name}")

    # Если папка пуста, переносим старые доски из boards.json.
    if not loaded and DATA_FILE.exists():
        try:
            old_boards = json.loads(
                DATA_FILE.read_text(encoding="utf-8")
            )

            for board_id, board in old_boards.items():
                loaded[board_id] = board
                save_board_file(board_id, board)

            if old_boards:
                backup_file = BASE_DIR / "boards_backup.json"
                DATA_FILE.replace(backup_file)
                print("Старые доски перенесены в saved_boards.")

        except (json.JSONDecodeError, OSError):
            print("Не удалось прочитать старый boards.json")

    return loaded


def save_board_file(board_id, board):
    file = SAVED_BOARDS_DIR / f"{board_id}.json"
    temporary_file = file.with_suffix(".tmp")

    temporary_file.write_text(
        json.dumps(board, ensure_ascii=False),
        encoding="utf-8"
    )
    temporary_file.replace(file)


def save_board(board_id):
    save_board_file(board_id, boards[board_id])


boards = load_boards()

rooms = {
    board_id: board.get("segments", [])
    for board_id, board in boards.items()
}
connections = {
    board_id: set()
    for board_id in boards
}


@app.get("/")
async def home(request: Request):
    board_list = [
        {"id": board_id, "name": board.get("name", "Без названия")}
        for board_id, board in boards.items()
    ]

    return templates.TemplateResponse(
        request=request,
        name="home.html",
        context={"boards": board_list}
    )


@app.get("/create")
async def create_room():
    board_id = str(uuid.uuid4())[:8]

    boards[board_id] = {
        "name": "Новая доска",
        "segments": []
    }
    rooms[board_id] = boards[board_id]["segments"]
    connections[board_id] = set()

    save_board(board_id)

    return RedirectResponse(
        url=f"/room/{board_id}",
        status_code=303
    )

@app.post("/delete/{board_id}")
async def delete_board(board_id: str):
    if board_id not in boards:
        return JSONResponse(
            {"error": "Доска не найдена"},
            status_code=404
        )

    # Удаляем файл доски с диска
    board_file = Path("saved_boards") / f"{board_id}.json"

    if board_file.exists():
        board_file.unlink()

    # Удаляем доску из памяти
    boards.pop(board_id, None)
    rooms.pop(board_id, None)
    connections.pop(board_id, None)

    return {"success": True}

@app.post("/rename/{room_id}")
async def rename_board(room_id: str, request: Request):
    if room_id not in boards:
        return JSONResponse(
            {"error": "Доска не найдена"},
            status_code=404
        )

    try:
        data = await request.json()
        name = str(data.get("name", "")).strip()
    except (json.JSONDecodeError, AttributeError):
        return JSONResponse(
            {"error": "Некорректные данные"},
            status_code=400
        )

    if not name:
        return JSONResponse(
            {"error": "Название не может быть пустым"},
            status_code=400
        )

    boards[room_id]["name"] = name[:100]
    save_board(room_id)

    return {"success": True, "name": boards[room_id]["name"]}


@app.get("/room/{room_id}")
async def room_page(request: Request, room_id: str):
    if room_id not in boards:
        boards[room_id] = {
            "name": "Новая доска",
            "segments": []
        }
        rooms[room_id] = boards[room_id]["segments"]
        connections[room_id] = set()
        save_board(room_id)

    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"room_id": room_id}
    )


@app.websocket("/ws/{room_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str):
    await websocket.accept()

    if room_id not in boards:
        boards[room_id] = {
            "name": "Новая доска",
            "segments": []
        }
        rooms[room_id] = boards[room_id]["segments"]
        connections[room_id] = set()
        save_board(room_id)

    connections[room_id].add(websocket)

    await websocket.send_json({
        "type": "init",
        "segments": rooms[room_id]
    })

    try:
        while True:
            message = await websocket.receive_text()
            data = json.loads(message)

            if data.get("type") == "clear":
                rooms[room_id].clear()
                save_board(room_id)

            elif data.get("type") == "segment":
                rooms[room_id].append(data)
                save_board(room_id)

            elif data.get("type") == "erase":
                erase_size = float(data.get("size", 1))
                erase_radius = erase_size / 2

                eraser = {
                    "x1": float(data["x1"]),
                    "y1": float(data["y1"]),
                    "x2": float(data["x2"]),
                    "y2": float(data["y2"]),
                    "size": erase_size
                }

                def point_to_segment_distance(px, py, segment):
                    dx = segment["x2"] - segment["x1"]
                    dy = segment["y2"] - segment["y1"]
                    length_squared = dx * dx + dy * dy

                    if length_squared == 0:
                        return ((px - segment["x1"]) ** 2 +
                                (py - segment["y1"]) ** 2) ** 0.5

                    t = max(0, min(1,
                        ((px - segment["x1"]) * dx +
                         (py - segment["y1"]) * dy) / length_squared
                    ))

                    x = segment["x1"] + t * dx
                    y = segment["y1"] + t * dy

                    return ((px - x) ** 2 + (py - y) ** 2) ** 0.5

                def touches(segment):
                    if segment.get("isEraser"):
                        return False

                    return (
                        point_to_segment_distance(
                            segment["x1"], segment["y1"], eraser
                        ) <= erase_radius + segment["size"] / 2
                        or point_to_segment_distance(
                            segment["x2"], segment["y2"], eraser
                        ) <= erase_radius + segment["size"] / 2
                        or point_to_segment_distance(
                            eraser["x1"], eraser["y1"], segment
                        ) <= erase_radius + eraser["size"] / 2
                        or point_to_segment_distance(
                            eraser["x2"], eraser["y2"], segment
                        ) <= erase_radius + eraser["size"] / 2
                    )

                rooms[room_id][:] = [
                    segment for segment in rooms[room_id]
                    if not touches(segment)
                ]

                boards[room_id]["segments"] = rooms[room_id]
                save_board(room_id)

            else:
                continue

            for connection in list(connections[room_id]):
                if connection != websocket:
                    try:
                        await connection.send_json(data)
                    except Exception:
                        connections[room_id].discard(connection)

    except (WebSocketDisconnect, json.JSONDecodeError):
        connections[room_id].discard(websocket)
