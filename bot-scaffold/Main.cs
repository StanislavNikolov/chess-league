﻿MyBot bot = new MyBot();

while (true)
{
	// Read current position as fen from stdin.
	string fen = Console.ReadLine();
	ChessChallenge.Chess.Board chessBoard = new();
	chessBoard.LoadPosition(fen);
	ChessChallenge.API.Board apiBoard = new(chessBoard);

	// Read current timer state from stdin.
	string[] tokens = Console.ReadLine().Split(' ');
	int millisRemaining = int.Parse(tokens[0]);
	int opponentMillisRemaining = int.Parse(tokens[1]);
	int startingTimeMillis = int.Parse(tokens[2]);
	ChessChallenge.API.Timer apiTimer = new(millisRemaining, opponentMillisRemaining, startingTimeMillis);

	// Think and write move to stdout.
	ChessChallenge.API.Move move = bot.Think(apiBoard, apiTimer);
	Console.WriteLine($"{move}");
}