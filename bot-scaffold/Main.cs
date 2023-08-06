MyBot bot = new MyBot();

while (true)
{
	string fen = Console.ReadLine();
	ChessChallenge.Chess.Board chessBoard = new();
	chessBoard.LoadPosition(fen);
	ChessChallenge.API.Board apiBoard = new(chessBoard);

	// TODO load timer from STDIN
	ChessChallenge.API.Timer apiTimer = new(1000, 1000, 1000);
	ChessChallenge.API.Move move = bot.Think(apiBoard, apiTimer);
	Console.WriteLine($"{move}");
}