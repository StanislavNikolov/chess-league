namespace ChessChallenge.Chess
{
    using System.Linq;

    public static class Arbiter
    {
        // Test for insufficient material (Note: not all cases are implemented)
        public static bool InsufficentMaterial(Board board)
        {
            // Can't have insufficient material with pawns on the board
            if (board.pawns[Board.WhiteIndex].Count > 0 || board.pawns[Board.BlackIndex].Count > 0)
            {
                return false;
            }

            // Can't have insufficient material with queens/rooks on the board
            if (board.FriendlyOrthogonalSliders != 0 || board.EnemyOrthogonalSliders != 0)
            {
                return false;
            }

            // If no pawns, queens, or rooks on the board, then consider knight and bishop cases
            int numWhiteBishops = board.bishops[Board.WhiteIndex].Count;
            int numBlackBishops = board.bishops[Board.BlackIndex].Count;
            int numWhiteKnights = board.knights[Board.WhiteIndex].Count;
            int numBlackKnights = board.knights[Board.BlackIndex].Count;
            int numWhiteMinors = numWhiteBishops + numWhiteKnights;
            int numBlackMinors = numBlackBishops + numBlackKnights;
            int numMinors = numWhiteMinors + numBlackMinors;

            // Lone kings or King vs King + single minor: is insuffient
            if (numMinors <= 1)
            {
                return true;
            }

            // Bishop vs bishop: is insufficient when bishops are same colour complex
            if (numMinors == 2 && numWhiteBishops == 1 && numBlackBishops == 1)
            {
                bool whiteBishopIsLightSquare = BoardHelper.LightSquare(board.bishops[Board.WhiteIndex][0]);
                bool blackBishopIsLightSquare = BoardHelper.LightSquare(board.bishops[Board.BlackIndex][0]);
                return whiteBishopIsLightSquare == blackBishopIsLightSquare;
            }

            return false;


        }
    }
}