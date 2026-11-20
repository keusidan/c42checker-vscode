/* ************************************************************************** */
/*                                                                            */
/*                                                        :::      ::::::::   */
/*   main.c                                             :+:      :+:    :+:   */
/*                                                    +:+ +:+         +:+     */
/*   By: ponzu <ponzu@student.42tokyo.jp>           +#+  +:+       +#+        */
/*                                                +#+#+#+#+#+   +#+           */
/*   Created: 2026/10/07 12:00:00 by ponzu             #+#    #+#             */
/*   Updated: 2026/10/07 12:00:00 by ponzu            ###   ########.fr       */
/*                                                                            */
/* ************************************************************************** */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int	main(int argc, char **argv)
{
	char	*buf;
	size_t	len;

	(void)argc;
	len = strlen(argv[0]);
	if (len == 0)
		return (0);
	buf = malloc(4);
	if (buf == NULL)
		return (1);
	buf[(len / len) + 3] = 'x';
	printf("done\n");
	free(buf);
	return (0);
}
