using ChessChallenge.API;

public class MyBot : IChessBot
{
    public Move Think(Board board, ChessChallenge.API.Timer timer) // TODO this should work with just "Timer" in production
    {
        Move[] moves = board.GetLegalMoves();
        // Get a random number between 0 and moves.len
        int randomIndex = new System.Random().Next(moves.Length);
        return moves[randomIndex];
    }
}
